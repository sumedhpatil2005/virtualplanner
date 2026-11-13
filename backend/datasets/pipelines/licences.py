"""Licence statements as published, verified by reading the publisher page on 2026-11-13 (IST).

Quotes are copied from the cited page; do not paraphrase into a different licence.
"""
VERIFIED_AT = "2026-11-13T21:30+05:30"

LICENCES = {
    "copernicus_dem_glo30": {
        "publisher": "ESA / Copernicus (DLR, Airbus DS); AWS mirror managed by Sinergise",
        "licence_name": "Copernicus DEM GLO-30 free licence (ESA user licence / CCM terms)",
        "quote": "The GLO-30 and GLO-90 datasets are available worldwide with a free license.",
        "attribution_required": "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
        "url": "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
        "access_url": "https://registry.opendata.aws/copernicus-dem/",
    },
    "esa_worldcover_2021_v200": {
        "publisher": "ESA WorldCover project / VITO",
        "licence_name": "CC-BY 4.0",
        "quote": "License: CC-BY 4.0",
        "attribution_required": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (per PUM v2.0)",
        "url": "https://registry.opendata.aws/esa-worldcover-vito/",
    },
    "jrc_gsw": {
        "publisher": "European Commission Joint Research Centre / Google",
        "licence_name": "Copernicus Programme, free of charge without restriction of use",
        "quote": "All data here is produced under the Copernicus Programme and is provided free of charge, without restriction of use.",
        "attribution_required": "Source: EC JRC/Google; cite Pekel et al. 2016, Nature 540, 418-422",
        "url": "https://global-surface-water.appspot.com/download",
    },
    "sentinel2_l2a": {
        "publisher": "ESA / European Commission (Copernicus); COGs hosted by Element 84 Earth Search on AWS",
        "licence_name": "Legal notice on the use of Copernicus Sentinel Data and Service Information",
        "quote": "users shall have a free, full and open access to Copernicus Sentinel Data and Service Information without any express or implied warranty, including as regards quality and suitability for any purpose.",
        "attribution_required": "Contains modified Copernicus Sentinel data [Year]",
        "url": "https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice.pdf",
    },
    "google_open_buildings_v3": {
        "publisher": "Google Research",
        "licence_name": "CC BY 4.0 or ODbL v1.0 (user's choice)",
        "quote": "The data is shared under the Creative Commons Attribution (CC BY-4.0) license and the Open Data Commons Open Database License (ODbL) v1.0 license. As the user, you can pick which of the two licenses you prefer and use the data under the terms of that license.",
        "url": "https://sites.research.google/gr/open-buildings/",
    },
    "ms_global_ml_buildings": {
        "publisher": "Microsoft (Bing Maps)",
        "licence_name": "CDLA Permissive 2.0",
        "quote": "This data is licensed by Microsoft under the CDLA Permissive 2.0.",
        "url": "https://github.com/microsoft/GlobalMLBuildingFootprints",
    },
    "soilgrids_250m_v2": {
        "publisher": "ISRIC - World Soil Information",
        "licence_name": "CC BY 4.0",
        "quote": "Since 2019, SoilGrids products are provided under the CC BY 4.0 (publicly accessible environmental data; see also the ISRIC software and data policy).",
        "url": "https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_02.html",
    },
    "chirps_v2": {
        "publisher": "Climate Hazards Center, UC Santa Barbara",
        "licence_name": "Public domain (CC0 waiver)",
        "quote": "To the extent possible under the law, Pete Peterson has waived all copyright and related or neighboring rights to CHIRPS. CHIRPS data is in the public domain as registered with Creative Commons.",
        "url": "https://www.chc.ucsb.edu/data/chirps",
    },
    "osm": {
        "publisher": "OpenStreetMap contributors (Geofabrik extract)",
        "licence_name": "ODbL 1.0",
        "quote": "Open Data Commons Open Database License (ODbL) [phrase present on the copyright page, checked 2026-11-13]",
        "url": "https://www.openstreetmap.org/copyright",
    },
}


def licence_block(source_id: str) -> dict:
    d = dict(LICENCES.get(source_id, {"licence_name": "UNKNOWN"}))
    d["verified_at"] = VERIFIED_AT
    return d
